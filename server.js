const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

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

function broadcast(room, event, excludeClientId) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;

  for (const [clientId, client] of room.clients.entries()) {
    if (excludeClientId && clientId === excludeClientId) {
      continue;
    }

    client.res.write(payload);
  }
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

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
        res: null
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

    if (req.method === "GET" && url.pathname === "/api/stream") {
      const roomId = String(url.searchParams.get("roomId") || "").trim().toLowerCase();
      const clientId = String(url.searchParams.get("clientId") || "").trim();

      if (!roomId || !clientId) {
        sendJson(res, 400, { error: "Missing roomId or clientId." });
        return;
      }

      const room = getRoom(roomId);
      const client = room.clients.get(clientId);

      if (!client) {
        sendJson(res, 404, { error: "Client not found." });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      res.write("retry: 1500\n\n");

      client.res = res;

      req.on("close", () => {
        const activeRoom = rooms.get(roomId);
        const activeClient = activeRoom?.clients.get(clientId);
        if (!activeRoom || !activeClient) {
          return;
        }

        activeRoom.clients.delete(clientId);
        broadcast(activeRoom, {
          type: "presence",
          action: "leave",
          clientId,
          name: activeClient.name
        });

        if (activeRoom.clients.size === 0) {
          rooms.delete(roomId);
        }
      });
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

      const room = getRoom(roomId);
      const sender = room.clients.get(clientId);

      if (!sender) {
        sendJson(res, 404, { error: "Unknown sender." });
        return;
      }

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
        if (target?.res) {
          target.res.write(`data: ${JSON.stringify(outbound)}\n\n`);
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

server.listen(PORT, () => {
  console.log(`PVT Area running at http://localhost:${PORT}`);
});
