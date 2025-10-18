// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ---- SOCKET.IO ----
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

// ---- ENVIRONMENT ----
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET || "replace_this_in_prod";

// ---- MONGOOSE MODELS ----
const userSchema = new mongoose.Schema({
  busId: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const locationSchema = new mongoose.Schema({
  busId: { type: String, required: true, index: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  speed: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now, index: true },
});

const lastLocationSchema = new mongoose.Schema({
  busId: { type: String, required: true, unique: true },
  latitude: Number,
  longitude: Number,
  speed: Number,
  timestamp: Date,
});

const User = mongoose.model("User", userSchema);
const Location = mongoose.model("Location", locationSchema);
const LastLocation = mongoose.model("LastLocation", lastLocationSchema);

// ---- DB CONNECT ----
async function connectDb() {
  if (!MONGO_URI) {
    console.error("MONGO_URI not set. Set it in .env");
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI);
  console.log("✅ MongoDB connected");
}
connectDb().catch(err => { console.error("Mongo connection error:", err); process.exit(1); });

// ---- JWT HELPERS ----
function createToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

async function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ---- ROUTES ----

// Health check
app.get("/health", (req, res) => res.send("Bus Tracker Server running"));

// Register (JWT only for auth, optional)
app.post("/register", async (req, res) => {
  try {
    const { busId, password } = req.body;
    if (!busId || !password) return res.status(400).json({ error: "Missing busId/password" });

    const existing = await User.findOne({ busId });
    if (existing) return res.status(409).json({ error: "busId already exists" });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = new User({ busId, passwordHash });
    await user.save();

    const token = createToken({ busId, id: user._id });
    return res.json({ success: true, busId, token });
  } catch (err) {
    console.error("register err:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { busId, password } = req.body;
    if (!busId || !password) return res.status(400).json({ error: "Missing fields" });

    const user = await User.findOne({ busId });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = createToken({ busId, id: user._id });
    return res.json({ success: true, busId, token });
  } catch (err) {
    console.error("login err:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// Get latest bus locations (public)
app.get("/latest", async (req, res) => {
  try {
    const rows = await LastLocation.find({});
    res.json({ success: true, buses: rows });
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

// NEW: Get a list of currently active bus IDs for the dropdown
app.get("/activeBuses", async (req, res) => {
  try {
    const buses = await LastLocation.find({}).select("busId -_id");
    const busIds = buses.map(b => b.busId);
    res.json(busIds);
  } catch (err) {
    console.error("activeBuses err:", err);
    res.status(500).json({ error: "server error" });
  }
});


// ---- SOCKET.IO ----
io.on("connection", (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);

  // This endpoint is used by the bus driver's device to send location data.
  socket.on("updateLocation", async (data) => {
    try {
      const { busId, latitude, longitude, speed, timestamp } = data;
      if (!busId || latitude == null || longitude == null) return;

      const locDoc = new Location({
        busId,
        latitude,
        longitude,
        speed: speed ?? 0,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
      });
      await locDoc.save();

      await LastLocation.findOneAndUpdate(
        { busId },
        { busId, latitude, longitude, speed: speed ?? 0, timestamp: locDoc.timestamp },
        { upsert: true, new: true }
      );

      // This emits the update to all connected web clients.
      io.emit("busLocationUpdate", { busId, latitude, longitude, speed, timestamp: locDoc.timestamp.toISOString() });
      console.log(`📍 Saved/Emitted Bus ${busId}`, { latitude, longitude, speed });
    } catch (err) {
      console.error("updateLocation err:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`❌ Socket disconnected: ${socket.id}`);
  });

  socket.on("connect_error", (err) => {
    console.log("⚠️ Connect error for", socket.id, err);
  });
});

// ---- START SERVER ----
server.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
