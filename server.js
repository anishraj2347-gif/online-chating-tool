const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const POLL_TIMEOUT_MS = 25000;
const CLIENT_TTL_MS = 45000;
const CLEANUP_INTERVAL_MS = 10000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Map(),
      history: []
    });
  }

  return rooms.get(roomId);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2e6) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function touchClient(client) {
  client.lastSeenAt = Date.now();
}

function clearPendingPoll(client) {
  if (client.pendingTimer) {
    clearTimeout(client.pendingTimer);
    client.pendingTimer = null;
  }

  client.pendingRes = null;
}

function flushClientQueue(client) {
  if (!client.pendingRes || client.eventQueue.length === 0) {
    return;
  }

  const res = client.pendingRes;
  const events = client.eventQueue.splice(0);
  clearPendingPoll(client);
  sendJson(res, 200, { events });
}

function queueEvent(client, event) {
  client.eventQueue.push(event);
  flushClientQueue(client);
}

function broadcast(room, event, excludeClientId) {
  for (const [clientId, client] of room.clients.entries()) {
    if (excludeClientId && clientId === excludeClientId) {
      continue;
    }

    queueEvent(client, event);
  }
}

function removeClient(roomId, clientId, notify) {
  const room = rooms.get(roomId);
  const client = room?.clients.get(clientId);

  if (!room || !client) {
    return;
  }

  clearPendingPoll(client);
  room.clients.delete(clientId);

  if (notify) {
    broadcast(room, {
      type: "presence",
      action: "leave",
      clientId,
      name: client.name
    });
  }

  if (room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function pruneStaleClients() {
  const now = Date.now();

  for (const [roomId, room] of rooms.entries()) {
    for (const [clientId, client] of room.clients.entries()) {
      if (now - client.lastSeenAt > CLIENT_TTL_MS) {
        removeClient(roomId, clientId, true);
      }
    }
  }
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const unsafePath = path.normalize(path.join(PUBLIC_DIR, urlPath));

  if (!unsafePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(unsafePath, (error, file) => {
    if (error) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(unsafePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(file);
  });
}

setInterval(pruneStaleClients, CLEANUP_INTERVAL_MS).unref();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        service: "pvt-area",
        uptime: Math.round(process.uptime())
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/join") {
      const rawBody = await collectBody(req);
      const body = JSON.parse(rawBody || "{}");
      const roomId = String(body.roomId || "").trim().toLowerCase();
      const name = String(body.name || "").trim().slice(0, 32);

      if (!roomId || !name) {
        sendJson(res, 400, { error: "Room and display name are required." });
        return;
      }

      const room = getRoom(roomId);
      const clientId = randomUUID();

      room.clients.set(clientId, {
        id: clientId,
        name,
        eventQueue: [],
        pendingRes: null,
        pendingTimer: null,
        lastSeenAt: Date.now()
      });

      const participants = Array.from(room.clients.values())
        .filter((client) => client.id !== clientId)
        .map((client) => ({ id: client.id, name: client.name }));

      sendJson(res, 200, {
        clientId,
        participants,
        history: room.history
      });

      broadcast(room, {
        type: "presence",
        action: "join",
        clientId,
        name
      }, clientId);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/poll") {
      const roomId = String(url.searchParams.get("roomId") || "").trim().toLowerCase();
      const clientId = String(url.searchParams.get("clientId") || "").trim();

      if (!roomId || !clientId) {
        sendJson(res, 400, { error: "Missing roomId or clientId." });
        return;
      }

      const room = rooms.get(roomId);
      const client = room?.clients.get(clientId);

      if (!room || !client) {
        sendJson(res, 404, { error: "Client not found." });
        return;
      }

      touchClient(client);

      if (client.eventQueue.length > 0) {
        sendJson(res, 200, { events: client.eventQueue.splice(0) });
        return;
      }

      clearPendingPoll(client);
      client.pendingRes = res;
      client.pendingTimer = setTimeout(() => {
        if (client.pendingRes === res) {
          clearPendingPoll(client);
          sendJson(res, 200, { events: [] });
        }
      }, POLL_TIMEOUT_MS);

      req.on("close", () => {
        if (client.pendingRes === res) {
          clearPendingPoll(client);
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/leave") {
      const rawBody = await collectBody(req);
      const body = JSON.parse(rawBody || "{}");
      const roomId = String(body.roomId || "").trim().toLowerCase();
      const clientId = String(body.clientId || "").trim();

      if (!roomId || !clientId) {
        sendJson(res, 400, { error: "Missing roomId or clientId." });
        return;
      }

      removeClient(roomId, clientId, true);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/event") {
      const rawBody = await collectBody(req);
      const event = JSON.parse(rawBody || "{}");
      const roomId = String(event.roomId || "").trim().toLowerCase();
      const clientId = String(event.clientId || "").trim();

      if (!roomId || !clientId) {
        sendJson(res, 400, { error: "Missing roomId or clientId." });
        return;
      }

      const room = rooms.get(roomId);
      const sender = room?.clients.get(clientId);

      if (!room || !sender) {
        sendJson(res, 404, { error: "Unknown sender." });
        return;
      }

      touchClient(sender);

      const outbound = {
        ...event,
        serverTimestamp: Date.now()
      };

      if (event.type === "chat") {
        room.history.push(outbound);
        if (room.history.length > 200) {
          room.history.shift();
        }
      }

      if (event.targetClientId) {
        const target = room.clients.get(event.targetClientId);
        if (target) {
          queueEvent(target, outbound);
        }
      } else {
        broadcast(room, outbound, clientId);
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`PVT Area running at http://localhost:${PORT}`);
});
