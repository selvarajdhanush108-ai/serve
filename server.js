// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

// Create Express app
const app = express();
const server = http.createServer(app);

// Socket.io setup with CORS
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins (driver + passenger apps)
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

// PORT for Render deployment
const PORT = process.env.PORT || 3000;

// In-memory store for latest bus locations
let buses = {};

// API route to check server health
app.get("/", (req, res) => {
  res.send("Bus Tracker Server is running!");
});

// Socket.io connection
io.on("connection", (socket) => {
  console.log(`🔌 Driver connected: ${socket.id}`);

  // Receive location updates from driver
  socket.on("updateLocation", (data) => {
    const { busId, latitude, longitude, timestamp } = data;

    // Save latest location
    buses[busId] = { latitude, longitude, timestamp };

    // Broadcast to all connected clients (passengers)
    io.emit("busLocationUpdate", { busId, latitude, longitude, timestamp });

    console.log(`📍 Updated location for Bus ${busId}:`, data);
  });

  socket.on("disconnect", () => {
    console.log(`❌ Driver disconnected: ${socket.id}`);
  });

  socket.on("connect_error", (err) => {
    console.log("⚠️ Connection error:", err);
  });
});

// Periodic broadcast of all buses (optional, ensures new clients get current data)
setInterval(() => {
  io.emit("busLocationUpdate", buses);
}, 5000); // every 5 seconds

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Socket server running on port ${PORT}`);
});
