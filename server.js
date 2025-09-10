// server.js
// Simple Socket.io signaling server for 2-person rooms

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// Serve static files (index.html, script.js, etc.)
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("join", (roomId, ack) => {
    if (!roomId) {
      ack && ack({ ok: false, error: "No roomId provided." });
      return;
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients >= 2) {
      ack && ack({ ok: false, error: "Room full (2 users max)." });
      return;
    }

    socket.join(roomId);
    joinedRoom = roomId;

    const shouldCreateOffer = numClients === 1; // second user triggers offer
    ack && ack({ ok: true, shouldCreateOffer, clients: numClients + 1 });

    // Notify peer someone joined
    socket.to(roomId).emit("peer-joined");
  });

  // Forward signaling messages to the other peer
  socket.on("offer", (payload) => {
    if (joinedRoom) socket.to(joinedRoom).emit("offer", payload);
  });

  socket.on("answer", (payload) => {
    if (joinedRoom) socket.to(joinedRoom).emit("answer", payload);
  });

  socket.on("candidate", (candidate) => {
    if (joinedRoom) socket.to(joinedRoom).emit("candidate", candidate);
  });

  // Handle disconnection (refresh, tab close, network drop)
  socket.on("disconnect", () => {
    if (joinedRoom) {
      socket.to(joinedRoom).emit("peer-disconnected");

      // Explicitly leave the room (important for refresh cases)
      socket.leave(joinedRoom);

      // Cleanup if the room is empty
      const room = io.sockets.adapter.rooms.get(joinedRoom);
      if (!room || room.size === 0) {
        console.log(`Room ${joinedRoom} is now empty, cleaned up.`);
      }

      joinedRoom = null;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
});