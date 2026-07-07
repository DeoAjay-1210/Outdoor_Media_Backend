const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);


require("dotenv").config();
const path = require("path");   
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const authRoutes = require("./routes/Admin/UserRoutes/UserRoutes");
const mediaRoutes = require("./routes/Admin/MediaOnboardingRoutes/MediaOnboardingRoutes");
const ledgerRoutes = require("./routes/Admin/MediaOnboardingRoutes/LedgerRoutes");
const RentalDue = require("./routes/Admin/MediaOnboardingRoutes/rentalDueRoutes");
const gstDetailRoutes = require('./routes/Admin/GstDetailRoutes/gstDetailRoutes');
connectDB();

const app = express();

app.use(cors());
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));
// Admin route
app.use("/admin", authRoutes);
app.use("/admin", mediaRoutes);
app.use("/admin", ledgerRoutes);
app.use("/admin", RentalDue);
app.use('/gstdetails', gstDetailRoutes);

app.get("/", (req, res) => {
  res.send("API Running");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        // Allow any vercel.app subdomain for preview deployments
        if (origin.includes(".vercel.app")) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  }),
);