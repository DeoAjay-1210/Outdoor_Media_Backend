const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]);


require("dotenv").config();
const path = require("path");   
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const authRoutes = require("./routes/Admin/UserRoutes/UserRoutes");
const mediaRoutes = require("./routes/Admin/MediaOnboardingRoutes/MediaOnboardingRoutes");
connectDB();

const app = express();

app.use(cors());
app.use(express.json());
app.use("/public", express.static(path.join(__dirname, "public")));
// Admin route
app.use("/admin", authRoutes);
app.use("/admin", mediaRoutes);

app.get("/", (req, res) => {
  res.send("API Running");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});