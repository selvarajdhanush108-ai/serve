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

// socket.io
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// Environment vars
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
  await mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });
  console.log("✅ MongoDB connected");
}
connectDb().catch((err) => {
  console.error("Mongo connection error:", err);
  process.exit(1);
});

// ---- HELPERS ----
function createToken(payload) {
  // short expiry recommended e.g. 7d or hours
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

async function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

// ---- AUTH ROUTES ----

// Register — create a driver user (you can disable in production or secure it)
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
    return res.json({ success: true, token, busId });
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
    return res.json({ success: true, token, busId });
  } catch (err) {
    console.error("login err:", err);
    return res.status(500).json({ error: "server error" });
  }
});

// Public health / get latest locations
app.get("/health", (req, res) => res.send("Bus Tracker Server running"));
app.get("/latest", async (req, res) => {
  // return all last-known positions (small scale). For large scale add pagination.
  try {
    const rows = await LastLocation.find({});
    res.json({ success: true, buses: rows });
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

// ---- SOCKET AUTH MIDDLEWARE ----
// Expect clients to pass token in socket.handshake.auth.token
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Auth token missing"));
    const payload = await verifyToken(token);
    socket.data.auth = payload; // store auth data on socket
    return next();
  } catch (err) {
    console.warn("Socket auth failed:", err.message || err);
    return next(new Error("Authentication error"));
  }
});

// ---- SOCKET.IO CONNECTION ----
io.on("connection", (socket) => {
  const auth = socket.data.auth;
  console.log(`🔌 Authenticated connection: ${socket.id} busId=${auth?.busId}`);

  socket.on("updateLocation", async (data) => {
    try {
      // data should contain: { busId, latitude, longitude, speed, timestamp? }
      const { busId, latitude, longitude, speed, timestamp } = data;

      // optional: ensure busId matches token busId
      if (String(auth?.busId) !== String(busId)) {
        console.warn("busId mismatch, ignoring:", { tokenBusId: auth?.busId, bodyBusId: busId });
        return socket.emit("error", { error: "busId mismatch" });
      }

      // Save history
      const locDoc = new Location({
        busId,
        latitude,
        longitude,
        speed: speed ?? 0,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
      });
      await locDoc.save();

      // Upsert last known location (fast lookup)
      await LastLocation.findOneAndUpdate(
        { busId },
        {
          busId,
          latitude,
          longitude,
          speed: speed ?? 0,
          timestamp: timestamp ? new Date(timestamp) : new Date(),
        },
        { upsert: true, new: true }
      );

      // Broadcast to all clients (passengers)
      io.emit("busLocationUpdate", { busId, latitude, longitude, speed, timestamp: locDoc.timestamp });

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

// ---- OPTIONAL: periodic broadcast for new clients (not necessary if you call /latest) ----
// setInterval(async () => {
//   const rows = await LastLocation.find({});
//   io.emit("busLocationUpdateBulk", rows);
// }, 10000);

server.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
