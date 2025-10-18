require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const mongoose = require("mongoose");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Socket.IO
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

// ---- AUTH ROUTES (still optional, no JWT) ----
app.post("/register", async (req, res) => {
  try {
    const { busId, passwordHash } = req.body;
    if (!busId || !passwordHash) return res.status(400).json({ error: "Missing fields" });

    const existing = await User.findOne({ busId });
    if (existing) return res.status(409).json({ error: "busId already exists" });

    const user = new User({ busId, passwordHash });
    await user.save();

    return res.json({ success: true, busId });
  } catch (err) {
    console.error("register err:", err);
    return res.status(500).json({ error: "server error" });
  }
});

app.get("/health", (req, res) => res.send("Bus Tracker Server running"));
app.get("/latest", async (req, res) => {
  try {
    const rows = await LastLocation.find({});
    res.json({ success: true, buses: rows });
  } catch (err) {
    res.status(500).json({ error: "server error" });
  }
});

// ---- SOCKET.IO CONNECTION (No JWT) ----
io.on("connection", (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  socket.on("updateLocation", async (data) => {
    try {
      const { busId, latitude, longitude, speed, timestamp } = data;

      // Save history
      const locDoc = new Location({
        busId,
        latitude,
        longitude,
        speed: speed ?? 0,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
      });
      await locDoc.save();

      // Upsert last known location
      await LastLocation.findOneAndUpdate(
        { busId },
        { busId, latitude, longitude, speed: speed ?? 0, timestamp: locDoc.timestamp },
        { upsert: true, new: true }
      );

      // Broadcast to all clients
      io.emit("busLocationUpdate", { busId, latitude, longitude, speed, timestamp: locDoc.timestamp });
      console.log(`📍 Saved/Emitted Bus ${busId}`, { latitude, longitude, speed });
    } catch (err) {
      console.error("updateLocation err:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log(`❌ Socket disconnected: ${socket.id}`);
  });
});

// ---- START SERVER ----
server.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
