const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);
const cron = require("node-cron");

require("dotenv").config();
const path = require("path");   
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const authRoutes = require("./routes/Admin/UserRoutes/UserRoutes");
const mediaRoutes = require("./routes/Admin/MediaOnboardingRoutes/MediaOnboardingRoutes");
const ledgerRoutes = require("./routes/Admin/MediaOnboardingRoutes/LedgerRoutes");
const RentalDue = require("./routes/Admin/MediaOnboardingRoutes/rentalDueRoutes");
const RentalOOHExcelRoutes = require("./routes/Admin/MediaOnboardingRoutes/RentalOOHExcelRoutes");
const gstDetailRoutes = require('./routes/Admin/GstDetailRoutes/gstDetailRoutes');
const LandownerMasterRoutes = require("./routes/Admin/landOwnerMasterRoutes/landOwnerMasterRoutes");
const dashboardRoutes = require("./routes/Admin/DashboardRoutes/DashboardRoutes");
const cmdNotificationRoutes = require("./routes/Admin/NotificationRoutes/CmdNotificationRoutes");
const billingDateRevertRoutes = require("./routes/Admin/MediaOnboardingRoutes/BillingDateRevertRoutes");
const appUpdateRoutes = require("./routes/Admin/AppUpdateRoutes/AppUpdateRoutes");
const Media = require("./models/Admin/MediaOnboardingSchema/MediaOnboardingSchema")
connectDB();
(async () => {
  try {
    const result = await Media.syncBillingCycles();
    // console.log(`[syncBillingCycles startup] checked=${result.checked} updated=${result.updated}`);
  } catch (err) {
    // console.error("[syncBillingCycles startup] failed:", err.message);
  }
})();

cron.schedule("5 0 * * *", async () => {
  try {
    const result = await Media.syncBillingCycles();
    console.log(`[syncBillingCycles] checked=${result.checked} updated=${result.updated}`);
  } catch (err) {
    console.error("[syncBillingCycles] failed:", err.message);
  }
});

// Auto-apply current-month appraisals to totalRentalAmount (startup + daily 00:10)
const { applyDueAppraisals } = require("./controllers/Admin/MediaOnboardingController/MediaOnboardingController");
const runApplyDueAppraisals = async () => {
  try {
    const result = await applyDueAppraisals();
    // console.log(`[applyDueAppraisals] checked=${result.checked} applied=${result.applied} failed=${result.failed}`);
    if (result.failed) console.error("[applyDueAppraisals] errors:", result.details.filter((d) => d.error));
  } catch (err) {
    console.error("[applyDueAppraisals] failed:", err.message);
  }
};
runApplyDueAppraisals();
cron.schedule("10 0 * * *", runApplyDueAppraisals);

// Delete Executive / Manager / CMD notifications read more than
// CMD_NOTIFICATION_READ_RETENTION_MINUTES (.env, default 1 day) ago;
// unread ones are kept. Also removes CMD's copies of billing date revert
// requests the CMD already approved / rejected (startup + hourly at :15). For testing, set in .env:
// CMD_NOTIFICATION_READ_RETENTION_MINUTES=1 and CMD_NOTIFICATION_PURGE_CRON="* * * * *"
const { purgeOldCmdNotifications } = require("./controllers/Admin/NotificationController/CmdNotificationController");
const runPurgeCmdNotifications = async () => {
  try {
    await purgeOldCmdNotifications();
  } catch (err) {
    console.error("[purgeOldCmdNotifications] failed:", err.message);
  }
};
runPurgeCmdNotifications();

// One-time backfill: landowners without bankAccounts[] get their current
// bank details as the primary account (no-op once every owner has one)
const { seedLandOwnerBankAccounts } = require("./controllers/Admin/landOwnerMasterController/landOwnerMasterController");
seedLandOwnerBankAccounts()
  .then((r) => r.seeded && console.log(`[seedLandOwnerBankAccounts] seeded=${r.seeded}`))
  .catch((err) => console.error("[seedLandOwnerBankAccounts] failed:", err.message));
cron.schedule(process.env.CMD_NOTIFICATION_PURGE_CRON || "15 * * * *", runPurgeCmdNotifications);
const app = express();

app.use(cors());
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));
// Admin route
app.use("/admin", authRoutes);
app.use("/admin", mediaRoutes);
app.use("/admin", ledgerRoutes);
app.use("/admin", RentalDue);
app.use("/admin", RentalOOHExcelRoutes);
app.use("/admin", LandownerMasterRoutes);
app.use("/admin", dashboardRoutes);
app.use("/admin", cmdNotificationRoutes);
app.use("/admin", billingDateRevertRoutes);
app.use("/admin", appUpdateRoutes);
// Auto-publish a new public/apk/app-release.apk for the in-app updater (APP_UPDATE_AUTO_PUBLISH=0 to disable)
if (process.env.APP_UPDATE_AUTO_PUBLISH !== "0") require("./utils/apkAutoPublish").startApkAutoPublish();
app.use('/gstdetails', gstDetailRoutes);

app.get("/", (req, res) => {
  res.send("API Running");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
app.use(cors({
  origin: [
    "http://localhost:8080",
    "http://localhost:5000",
    "https://peaceful-entremet-3dd657.netlify.app",
    "https://adinn-space.sgp1.cdn.digitaloceanspaces.com",
    "https://adinn-outdoor-media.netlify.app",
    "http://192.168.1.42:5000",
    "http://192.168.1.39:5000",
    "https://adinn-space.sgp1.cdn.digitaloceanspaces.com/Rental-OOH",
    "https://adinn-space.sgp1.cdn.digitaloceanspaces.com/Rental-OOH/",
    "http://localhost:54571/",
    "http://localhost:54571",
    "https://adinntech.in/ooh-bills/api",
    "https://adinntech.in/",
    "https://adinntech.in"
    

  ],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
