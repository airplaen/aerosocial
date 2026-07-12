const { WebSocketServer, WebSocket } = require("ws");
const jwt = require("jsonwebtoken");

let wss = null;
let heartbeatInterval = null;

// Attaches a WebSocket server to the existing HTTP server on path /ws.
// Clients may optionally connect with ?token=<JWT> (same token used for the
// REST API) to identify themselves; the connection is still accepted
// without one so anonymous visitors can watch the public feed update live.
function initWebSocket(server, allowedOrigins = []) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, req) => {
    if (allowedOrigins.length && req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }

    try {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (token) socket.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      /* invalid/expired token: keep the connection open as anonymous */
    }

    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
    socket.send(JSON.stringify({ type: "connected" }));
  });

  // Drop dead sockets (e.g. laptop went to sleep, network dropped) every 30s.
  heartbeatInterval = setInterval(() => {
    wss.clients.forEach((socket) => {
      if (socket.isAlive === false) return socket.terminate();
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(heartbeatInterval));

  return wss;
}

// Sends { type, payload } as JSON to every currently-connected client.
function broadcast(type, payload) {
  if (!wss) return;
  const message = JSON.stringify({ type, payload });
  wss.clients.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  });
}

module.exports = { initWebSocket, broadcast };
